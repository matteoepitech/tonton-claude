import AppKit
import TontonCore

/// Decoded conversation images, so scrolling does not decode base64 again and again.
@MainActor
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, NSImage>()

    func image(for image: ImageData) -> NSImage? {
        let key = "\(image.data.count):\(image.data.prefix(64)):\(image.data.suffix(64))" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let data = Data(base64Encoded: image.data), let decoded = NSImage(data: data) else { return nil }
        cache.setObject(decoded, forKey: key)
        return decoded
    }
}
