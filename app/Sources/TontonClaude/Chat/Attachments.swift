import AppKit
import TontonCore
import UniformTypeIdentifiers

struct Attachment: Identifiable {
    let id = UUID()
    let name: String
    let mediaType: String
    let data: Data
    let thumbnail: NSImage

    var outgoing: OutgoingImage {
        OutgoingImage(name: name, mediaType: mediaType, data: data.base64EncodedString())
    }
}

/// Turns files, the clipboard and drops into attachments small enough to send through the relay.
enum AttachmentReader {
    private static let maxBytes = 3_000_000

    static func attachment(from data: Data, name: String) -> Attachment? {
        guard let image = NSImage(data: data) else { return nil }
        if data.count > maxBytes, let jpeg = jpegData(image) {
            let jpegName = (name as NSString).deletingPathExtension + ".jpg"
            return Attachment(name: jpegName, mediaType: "image/jpeg", data: jpeg, thumbnail: image)
        }
        let mediaType = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "image/png"
        return Attachment(name: name, mediaType: mediaType, data: data, thumbnail: image)
    }

    @MainActor
    static func pickFiles() -> [Attachment] {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        guard panel.runAboveNotch() == .OK else { return [] }
        return panel.urls.compactMap(fromFile)
    }

    static func fromClipboard() -> [Attachment] {
        let pasteboard = NSPasteboard.general
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingContentsConformToTypes: [UTType.image.identifier]]
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty {
            return urls.compactMap(fromFile)
        }
        guard let image = NSImage(pasteboard: pasteboard), let png = pngData(image) else { return [] }
        return attachment(from: png, name: "capture.png").map { [$0] } ?? []
    }

    /// Loads dropped files and images, then hands them over on the main thread.
    static func fromDrop(_ providers: [NSItemProvider], deliver: @escaping @MainActor (Attachment) -> Void) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, let attachment = fromFile(url) else { return }
                    Task { @MainActor in deliver(attachment) }
                }
            } else if provider.canLoadObject(ofClass: NSImage.self) {
                _ = provider.loadObject(ofClass: NSImage.self) { object, _ in
                    guard let image = object as? NSImage, let png = pngData(image),
                        let attachment = attachment(from: png, name: "image.png")
                    else { return }
                    Task { @MainActor in deliver(attachment) }
                }
            }
        }
    }

    private static func fromFile(_ url: URL) -> Attachment? {
        (try? Data(contentsOf: url)).flatMap { attachment(from: $0, name: url.lastPathComponent) }
    }

    private static func pngData(_ image: NSImage) -> Data? {
        image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .png, properties: [:])
    }

    private static func jpegData(_ image: NSImage) -> Data? {
        image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
    }
}
