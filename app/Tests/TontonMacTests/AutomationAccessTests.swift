import AppKit
import CoreServices
import XCTest

@testable import TontonMac

/// Which app the Automation permission is asked about: nothing is asked here.
final class AutomationAccessTests: XCTestCase {
    /// By bundle id, macOS never answered for Spotify while its updater's copy was registered too: the notch stayed on
    /// "Connecting to Spotify…".
    func testTargetsTheRunningProcess() throws {
        let current = NSRunningApplication.current
        let target = try XCTUnwrap(SystemAutomationAccess.target("com.spotify.client") { _ in [current] })
        XCTAssertEqual(target.descriptorType, typeKernelProcessID)
        let pid = target.data.withUnsafeBytes { $0.load(as: pid_t.self) }
        XCTAssertEqual(pid, current.processIdentifier)
    }

    func testNoTargetWhileNotRunning() {
        XCTAssertNil(SystemAutomationAccess.target("com.spotify.client") { _ in [] })
    }
}
