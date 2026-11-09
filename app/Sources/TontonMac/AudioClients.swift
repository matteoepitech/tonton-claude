import CoreAudio
import Darwin
import Foundation
import TontonCore

/// The processes that use audio, which tell which app plays sound when Now Playing can't. A protocol, so that tests read
/// none.
@MainActor
public protocol AudioClientSource: AnyObject {
    /// Calls `change` with the clients now, then each time one appears, goes, or starts or stops playing, until `stop()`.
    /// False when this Mac can't tell.
    func start(_ change: @escaping @MainActor ([SoundingApps.Client]) -> Void) -> Bool
    func stop()
}

/// Core Audio's process objects (`kAudioHardwarePropertyProcessObjectList`), public since macOS 14.2. Listing them asks
/// no permission: it says which process plays, never what. Before 14.2 the list isn't there and nothing shows. Changes
/// come from Core Audio's listeners, on the main queue: nothing polls.
@MainActor
public final class CoreAudioClients: AudioClientSource {
    private static let system = AudioObjectID(kAudioObjectSystemObject)
    private var change: (@MainActor ([SoundingApps.Client]) -> Void)?
    private var listListener: AudioObjectPropertyListenerBlock?
    private var clientListeners: [AudioObjectID: AudioObjectPropertyListenerBlock] = [:]
    /// The app of each process, read once: a browser for its helper.
    private var apps: [pid_t: String] = [:]
    private var bundleIds: [String: String] = [:]

    public init() {}

    public func start(_ change: @escaping @MainActor ([SoundingApps.Client]) -> Void) -> Bool {
        self.change = change
        if listListener != nil {
            deliver()
            return true
        }
        var address = Self.address(kAudioHardwarePropertyProcessObjectList)
        guard AudioObjectHasProperty(Self.system, &address) else { return false }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in MainActor.assumeIsolated { self?.listChanged() } }
        guard AudioObjectAddPropertyListenerBlock(Self.system, &address, .main, listener) == noErr else { return false }
        listListener = listener
        listChanged()
        return true
    }

    public func stop() {
        change = nil
        if let listener = listListener {
            var address = Self.address(kAudioHardwarePropertyProcessObjectList)
            AudioObjectRemovePropertyListenerBlock(Self.system, &address, .main, listener)
        }
        listListener = nil
        for (client, listener) in clientListeners { Self.unlisten(client, listener) }
        clientListeners = [:]
    }

    private func listChanged() {
        let clients = Set(Self.clients())
        for (client, listener) in clientListeners where !clients.contains(client) {
            Self.unlisten(client, listener)
            clientListeners[client] = nil
        }
        for client in clients where clientListeners[client] == nil {
            let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in MainActor.assumeIsolated { self?.deliver() } }
            for selector in [kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyIsRunningInput] {
                var address = Self.address(selector)
                AudioObjectAddPropertyListenerBlock(client, &address, .main, listener)
            }
            clientListeners[client] = listener
        }
        deliver()
    }

    private func deliver() {
        guard let change else { return }
        var seen: Set<pid_t> = []
        let clients = clientListeners.keys.compactMap { client -> SoundingApps.Client? in
            guard let pid = Self.number(client, kAudioProcessPropertyPID).map(pid_t.init(bitPattern:)), pid > 0 else { return nil }
            seen.insert(pid)
            return SoundingApps.Client(
                app: app(of: pid), output: Self.number(client, kAudioProcessPropertyIsRunningOutput) == 1,
                input: Self.number(client, kAudioProcessPropertyIsRunningInput) == 1)
        }
        apps = apps.filter { seen.contains($0.key) }
        change(clients)
    }

    /// The bundle id of the outermost app the process's executable sits in. "" when there is none, so that it is read once.
    private func app(of pid: pid_t) -> String? {
        if let known = apps[pid] { return known.isEmpty ? nil : known }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &path, UInt32(path.count))
        let bundle = length > 0 ? SoundingApps.outermostApp(String(cString: path)) : nil
        let id = bundle.map { bundle in
            if let known = bundleIds[bundle] { return known }
            let id = Bundle(path: bundle)?.bundleIdentifier ?? ""
            bundleIds[bundle] = id
            return id
        }
        apps[pid] = id ?? ""
        return id.flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func clients() -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var clients = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &clients) == noErr else { return [] }
        return Array(clients.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    /// A process's pid and its two flags are all 32-bit.
    private static func number(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func unlisten(_ client: AudioObjectID, _ listener: @escaping AudioObjectPropertyListenerBlock) {
        for selector in [kAudioProcessPropertyIsRunningOutput, kAudioProcessPropertyIsRunningInput] {
            var address = address(selector)
            AudioObjectRemovePropertyListenerBlock(client, &address, .main, listener)
        }
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }
}
