import Combine
import Foundation
import OSLog
import ServiceManagement
import TontonCore

/// User preferences, persisted in UserDefaults, plus the account (stored separately, see AccountStore).
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    static let defaultRelay = "https://tonton.d3l.tech"
    static let defaultQuickReplies = ["Continue", "Run the tests", "Explain what you just did", "Commit and push"]
    static let alertSounds = ["Glass", "Tink", "Ping", "Pop", "Purr", "Hero", "Submarine", "Funk", "Bottle", "Frog"]

    /// Relay
    @Published var serverURL: String
    @Published var account: Account?
    /// Off: the app stays disconnected from the relay.
    @Published var connectionEnabled: Bool

    /// General
    @Published var launchAtLogin: Bool
    @Published var showMenuBarIcon: Bool
    @Published var hotkey: HotKeyPreset
    @Published var display: DisplayChoice
    @Published var notchSize: NotchSizeChoice
    @Published var showCosts: Bool
    /// 0 keeps finished sessions until removed by hand.
    @Published var hideFinishedAfterHours: Int
    @Published var quickReplies: [String]
    /// Machines whose sessions stay out of the notch.
    @Published var hiddenMachines: Set<String>
    @Published var editor: EditorChoice
    /// Session ids, in the order they were pinned.
    @Published var pinnedSessions: [String]

    /// Notch and alerts
    @Published var openOnHover: Bool
    @Published var showActivityDots: Bool
    @Published var openOnPermission: Bool
    @Published var showAlerts: Bool
    @Published var alertOnFinish: Bool
    @Published var soundOnAttention: Bool
    @Published var alertSound: String
    @Published var haptics: Bool
    @Published var systemNotifications: Bool
    @Published var quietHours: Bool
    /// Minutes after midnight.
    @Published var quietStart: Int
    @Published var quietEnd: Int

    var isConfigured: Bool { account != nil }
    var relayURL: String { account?.relay ?? serverURL }

    /// No sound, banner or notification while quiet hours are on.
    var isQuietNow: Bool {
        guard quietHours, quietStart != quietEnd else { return false }
        let time = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let now = (time.hour ?? 0) * 60 + (time.minute ?? 0)
        return quietStart < quietEnd ? (now >= quietStart && now < quietEnd) : (now >= quietStart || now < quietEnd)
    }

    private let defaults: UserDefaults
    private var subscriptions = Set<AnyCancellable>()

    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        func value<T>(_ key: String, _ fallback: T) -> T { defaults.object(forKey: key) as? T ?? fallback }
        func choice<T: RawRepresentable<String>>(_ key: String, _ fallback: T) -> T {
            T(rawValue: defaults.string(forKey: key) ?? "") ?? fallback
        }

        serverURL = value("serverURL", Self.defaultRelay)
        account = AccountStore.load()
        connectionEnabled = value("connectionEnabled", true)
        launchAtLogin = SMAppService.mainApp.status == .enabled
        showMenuBarIcon = value("showMenuBarIcon", false)
        hotkey = choice("hotkey", .optionCommandN)
        display = choice("display", .builtIn)
        notchSize = choice("notchSize", .standard)
        showCosts = value("showCosts", true)
        hideFinishedAfterHours = value("hideFinishedAfterHours", 0)
        quickReplies = value("quickReplies", Self.defaultQuickReplies)
        hiddenMachines = Set(value("hiddenMachines", [String]()))
        editor = choice("editor", EditorChoice.installed.first ?? .defaultApp)
        pinnedSessions = value("pinnedSessions", [String]())
        openOnHover = value("openOnHover", true)
        showActivityDots = value("showActivityDots", false)
        openOnPermission = value("openOnPermission", false)
        showAlerts = value("showAlerts", true)
        alertOnFinish = value("alertOnFinish", false)
        soundOnAttention = value("soundOnAttention", true)
        alertSound = value("alertSound", "Glass")
        haptics = value("haptics", true)
        systemNotifications = value("systemNotifications", false)
        quietHours = value("quietHours", false)
        quietStart = value("quietStart", 22 * 60)
        quietEnd = value("quietEnd", 8 * 60)

        persist($serverURL, "serverURL")
        persist($connectionEnabled, "connectionEnabled")
        persist($showMenuBarIcon, "showMenuBarIcon")
        persist($hotkey.map(\.rawValue), "hotkey")
        persist($display.map(\.rawValue), "display")
        persist($notchSize.map(\.rawValue), "notchSize")
        persist($showCosts, "showCosts")
        persist($hideFinishedAfterHours, "hideFinishedAfterHours")
        persist($quickReplies, "quickReplies")
        persist($hiddenMachines.map { Array($0).sorted() }, "hiddenMachines")
        persist($editor.map(\.rawValue), "editor")
        persist($pinnedSessions, "pinnedSessions")
        persist($openOnHover, "openOnHover")
        persist($showActivityDots, "showActivityDots")
        persist($openOnPermission, "openOnPermission")
        persist($showAlerts, "showAlerts")
        persist($alertOnFinish, "alertOnFinish")
        persist($soundOnAttention, "soundOnAttention")
        persist($alertSound, "alertSound")
        persist($haptics, "haptics")
        persist($systemNotifications, "systemNotifications")
        persist($quietHours, "quietHours")
        persist($quietStart, "quietStart")
        persist($quietEnd, "quietEnd")

        $account.dropFirst().sink { AccountStore.save($0) }.store(in: &subscriptions)
        $launchAtLogin.dropFirst().removeDuplicates().sink { Self.setLaunchAtLogin($0) }.store(in: &subscriptions)
    }

    private func persist<P: Publisher>(_ publisher: P, _ key: String) where P.Failure == Never {
        publisher.dropFirst().sink { [defaults] in defaults.set($0, forKey: key) }.store(in: &subscriptions)
    }

    private static func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            Logger.app.error("launch at login: \(error.localizedDescription)")
        }
    }
}

/// The account lives in a file readable by the user only: Keychain access breaks on every rebuild of an ad-hoc signed app.
enum AccountStore {
    private static var url: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("Tonton Claude")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory.appendingPathComponent("account.json")
    }

    static func load() -> Account? {
        try? JSONDecoder().decode(Account.self, from: Data(contentsOf: url))
    }

    static func save(_ account: Account?) {
        guard let account, let data = try? JSONEncoder().encode(account) else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
    }
}
