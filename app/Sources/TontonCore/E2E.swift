import CryptoKit
import Foundation

/// AES-256-GCM shared with the agents. Sealed values are base64 of nonce | ciphertext | tag, the layout of
/// `AES.GCM.SealedBox.combined`. The relay only ever sees these blobs.
public enum E2E {
    private static let additionalData = Data("tonton/v1".utf8)

    public enum Failure: Error { case invalidKey, invalidBlob }

    /// A new random account key, base64url encoded.
    public static func newKey() -> String {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64URLEncodedString()
    }

    public static func key(fromBase64URL string: String) throws -> SymmetricKey {
        guard let data = Data(base64URLEncoded: string), data.count == 32 else { throw Failure.invalidKey }
        return SymmetricKey(data: data)
    }

    public static func seal<T: Encodable>(_ value: T, with key: SymmetricKey) throws -> String {
        let box = try AES.GCM.seal(try JSONEncoder().encode(value), using: key, authenticating: additionalData)
        guard let combined = box.combined else { throw Failure.invalidBlob }
        return combined.base64EncodedString()
    }

    public static func open<T: Decodable>(_ blob: String, as type: T.Type, with key: SymmetricKey) throws -> T {
        guard let data = Data(base64Encoded: blob) else { throw Failure.invalidBlob }
        let plaintext = try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: key, authenticating: additionalData)
        return try JSONDecoder().decode(T.self, from: plaintext)
    }
}

extension Data {
    public init?(base64URLEncoded string: String) {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
