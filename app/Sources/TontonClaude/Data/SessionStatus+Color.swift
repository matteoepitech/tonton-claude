import AppKit
import TontonCore

extension SessionStatus {
    var color: NSColor {
        switch self {
        case .working, .starting: .systemGreen
        case .waiting: .systemYellow
        case .permission: .systemOrange
        case .idle: .systemBlue
        case .error: .systemRed
        case .ended, .offline: .systemGray
        }
    }
}
