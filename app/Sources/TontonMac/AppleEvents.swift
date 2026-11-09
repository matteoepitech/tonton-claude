import AppKit
import CoreServices
import Foundation
import TontonCore

/// What the music players of this Mac are driven through: AppleScript, the Automation permission, the apps that run and
/// the notifications players post. Each is a protocol so that tests send no Apple Event, ask nothing and launch nothing.

/// Runs AppleScript source and gives its result as text, or as bytes.
public protocol ScriptRunning: Sendable {
    func run(_ source: String) async throws -> String
    /// The bytes of what the script returns, such as the picture of Music's `data of artwork`: empty for none.
    func data(_ source: String) async throws -> Data
}

/// A script that failed, with AppleScript's error number: `MusicAccess.notPermittedError` when Automation is off.
public struct ScriptFailure: Error, Equatable {
    public let code: Int
    public init(code: Int) { self.code = code }
}

/// One script at a time, off the main thread: an Apple Event waits for the other app's answer, and NSAppleScript is not
/// safe to run on two threads at once.
public final class AppleScriptRunner: ScriptRunning, @unchecked Sendable {
    public static let shared = AppleScriptRunner()
    private let queue = DispatchQueue(label: "tech.d3l.tontonclaude.applescript", qos: .userInitiated)

    public func run(_ source: String) async throws -> String {
        try await execute(source) { $0.stringValue ?? "" }
    }

    /// A picture comes back as a descriptor of its format (`JPEG`, `PNGf`, `tdta`), whose data is the image itself.
    public func data(_ source: String) async throws -> Data {
        try await execute(source) { $0.data }
    }

    /// Runs `source` on the queue and reads its result there: the descriptor stays on that thread.
    private func execute<Value: Sendable>(
        _ source: String, _ read: @escaping @Sendable (NSAppleEventDescriptor) -> Value
    ) async throws
        -> Value
    {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                var error: NSDictionary?
                guard let script = NSAppleScript(source: source) else {
                    continuation.resume(throwing: ScriptFailure(code: 0))
                    return
                }
                let result = script.executeAndReturnError(&error)
                if let error {
                    continuation.resume(throwing: ScriptFailure(code: error[NSAppleScript.errorNumber] as? Int ?? 0))
                } else {
                    continuation.resume(returning: read(result))
                }
            }
        }
    }
}

/// Asks macOS whether Tonton may send an app Apple Events.
public protocol AutomationAccess: Sendable {
    /// Shows the system's prompt the first time, and waits for the answer.
    func request(_ bundleId: String) async -> MusicAccess
}

public struct SystemAutomationAccess: AutomationAccess {
    public init() {}

    public func request(_ bundleId: String) async -> MusicAccess {
        await withCheckedContinuation { continuation in
            // It waits for the user to answer the prompt: never on the main thread.
            DispatchQueue.global(qos: .userInitiated).async {
                let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
                let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, true)
                continuation.resume(returning: MusicAccess(automationStatus: status))
            }
        }
    }
}

/// The apps of this Mac, by bundle id.
@MainActor
public protocol RunningApps: AnyObject {
    func isInstalled(_ bundleId: String) -> Bool
    func isRunning(_ bundleId: String) -> Bool
    /// Calls `change` with true when the app launches and false when it quits.
    func observe(_ bundleId: String, _ change: @escaping @MainActor (Bool) -> Void)
    func activate(_ bundleId: String)
    func launch(_ bundleId: String)
}

@MainActor
public final class WorkspaceApps: RunningApps {
    private var observers: [NSObjectProtocol] = []

    public init() {}

    public func isInstalled(_ bundleId: String) -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) != nil
    }

    public func isRunning(_ bundleId: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty
    }

    public func observe(_ bundleId: String, _ change: @escaping @MainActor (Bool) -> Void) {
        let center = NSWorkspace.shared.notificationCenter
        for (name, running) in [
            (NSWorkspace.didLaunchApplicationNotification, true), (NSWorkspace.didTerminateApplicationNotification, false),
        ] {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { note in
                    let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                    guard app?.bundleIdentifier == bundleId else { return }
                    MainActor.assumeIsolated { change(running) }
                })
        }
    }

    /// The open notch makes Tonton the active app, which then hands the activation over, as macOS 14 wants it.
    public func activate(_ bundleId: String) {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return }
        NSApp.yieldActivation(to: app)
        app.activate()
    }

    public func launch(_ bundleId: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }
}

/// Notifications other apps post to every process, such as Spotify's when playback changes.
@MainActor
public protocol NotificationSource: AnyObject {
    /// Calls `handler` with each one's userInfo.
    func observe(_ name: String, _ handler: @escaping @MainActor ([AnyHashable: Any]) -> Void)
}

@MainActor
public final class DistributedNotifications: NSObject, NotificationSource {
    private var handlers: [String: [@MainActor ([AnyHashable: Any]) -> Void]] = [:]

    override public init() {}

    public func observe(_ name: String, _ handler: @escaping @MainActor ([AnyHashable: Any]) -> Void) {
        if handlers[name] == nil {
            // AppKit holds back distributed notifications while the app is not active, which an accessory app rarely is:
            // the closed notch would only learn of a new track once opened.
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(received), name: Notification.Name(name), object: nil, suspensionBehavior: .deliverImmediately)
        }
        handlers[name, default: []].append(handler)
    }

    /// Delivered on the main thread, through its run loop.
    @objc nonisolated private func received(_ note: Notification) {
        let name = note.name.rawValue
        // Read on the main thread only, by the handlers.
        nonisolated(unsafe) let userInfo = note.userInfo ?? [:]
        let deliver: @Sendable () -> Void = { [weak self] in
            MainActor.assumeIsolated {
                for handler in self?.handlers[name] ?? [] { handler(userInfo) }
            }
        }
        if Thread.isMainThread { deliver() } else { DispatchQueue.main.async(execute: deliver) }
    }
}
