import Foundation

/// Wyhash with seed 0, the hash of Bun's `Bun.hash` (Zig's std.hash.Wyhash): the agent names the entries of a Codex
/// rollout after it, and the Mac gives the entries it reads itself the same ids.
enum Wyhash {
    private static let secret: [UInt64] = [0xa076_1d64_78bd_642f, 0xe703_7ed1_a0b4_28db, 0x8ebc_6af0_9c88_c6e3, 0x5899_65cc_7537_4cc3]

    static func hash(_ text: String.UTF8View) -> UInt64 {
        let bytes = Array(text)
        return bytes.withUnsafeBytes { hash($0) }
    }

    static func hash(_ input: UnsafeRawBufferPointer) -> UInt64 {
        func read8(_ at: Int) -> UInt64 { UInt64(littleEndian: input.loadUnaligned(fromByteOffset: at, as: UInt64.self)) }
        func read4(_ at: Int) -> UInt64 { UInt64(UInt32(littleEndian: input.loadUnaligned(fromByteOffset: at, as: UInt32.self))) }
        var state = [mix(secret[0], secret[1]), 0, 0]
        state[1] = state[0]
        state[2] = state[0]
        var a: UInt64 = 0
        var b: UInt64 = 0
        let length = input.count
        if length <= 16 {
            if length >= 4 {
                let end = length - 4
                let quarter = (length >> 3) << 2
                a = (read4(0) << 32) | read4(quarter)
                b = (read4(end) << 32) | read4(end - quarter)
            } else if length > 0 {
                a = (UInt64(input[0]) << 16) | (UInt64(input[length >> 1]) << 8) | UInt64(input[length - 1])
            }
        } else {
            var start = 0
            if length >= 48 {
                while start + 48 < length {
                    for lane in 0..<3 {
                        state[lane] = mix(read8(start + 16 * lane) ^ secret[lane + 1], read8(start + 16 * lane + 8) ^ state[lane])
                    }
                    start += 48
                }
                state[0] ^= state[1] ^ state[2]
            }
            while start + 16 < length {
                state[0] = mix(read8(start) ^ secret[1], read8(start + 8) ^ state[0])
                start += 16
            }
            a = read8(length - 16)
            b = read8(length - 8)
        }
        a ^= secret[1]
        b ^= state[0]
        multiply(&a, &b)
        return mix(a ^ secret[0] ^ UInt64(length), b ^ secret[1])
    }

    private static func multiply(_ a: inout UInt64, _ b: inout UInt64) {
        let product = a.multipliedFullWidth(by: b)
        (a, b) = (product.low, product.high)
    }

    private static func mix(_ a: UInt64, _ b: UInt64) -> UInt64 {
        var (a, b) = (a, b)
        multiply(&a, &b)
        return a ^ b
    }
}
