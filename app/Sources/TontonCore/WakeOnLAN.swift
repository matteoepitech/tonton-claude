import Darwin
import Foundation

/// Wakes a sleeping machine with a magic packet: six 0xFF bytes, then its MAC address sixteen times, broadcast over UDP.
/// It only reaches machines on this Mac's local network, with Wake-on-LAN enabled.
public enum WakeOnLAN {
    public struct Target: Codable, Equatable, Sendable {
        public let mac: String
        public let broadcast: String

        public init(mac: String, broadcast: String) {
            self.mac = mac
            self.broadcast = broadcast
        }
    }

    /// The packet for a MAC address written `a4:83:e7:01:02:03` or `A4-83-E7-01-02-03`; nil when it is not one.
    public static func magicPacket(mac: String) -> Data? {
        let parts = mac.split(whereSeparator: { $0 == ":" || $0 == "-" })
        guard parts.count == 6 else { return nil }
        let bytes = parts.compactMap { $0.count == 2 ? UInt8($0, radix: 16) : nil }
        guard bytes.count == 6 else { return nil }
        return Data(repeating: 0xFF, count: 6) + (0..<16).reduce(Data()) { packet, _ in packet + Data(bytes) }
    }

    /// Sends the packet to each target's subnet and to the whole local network, on the usual ports 9 and 7.
    /// Returns how many sends left this Mac.
    @discardableResult
    public static func wake(_ targets: [Target]) -> Int {
        var sent = 0
        for target in targets {
            guard let packet = magicPacket(mac: target.mac) else { continue }
            for address in Set([target.broadcast, "255.255.255.255"]) {
                for port in [UInt16(9), 7] where send(packet, to: address, port: port) { sent += 1 }
            }
        }
        return sent
    }

    private static func send(_ packet: Data, to address: String, port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var on: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return false }
        var destination = sockaddr_in()
        destination.sin_family = sa_family_t(AF_INET)
        destination.sin_port = port.bigEndian
        guard inet_pton(AF_INET, address, &destination.sin_addr) == 1 else { return false }
        let result = packet.withUnsafeBytes { buffer in
            withUnsafePointer(to: &destination) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(fd, buffer.baseAddress, buffer.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        return result == packet.count
    }
}
