import Foundation
import Observation
import TontonCore
import UIKit
import UserNotifications

/// Tells the relay where to push: the device token for permission alerts, the Live Activity's tokens. Sent again on
/// each connection and whenever a token changes. Relays without an APNs key, or older than pushes, keep nothing.
@MainActor @Observable
final class PushRegistrar {
    /// Nil until the relay answered; false when it has no APNs key or is too old.
    private(set) var relayPushes: Bool?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// Why the phone could not get a device token, e.g. in the Simulator.
    private(set) var tokenProblem: String?
    /// Settings › Notifications › Permission requests.
    var alertsEnabled: Bool = UserDefaults.standard.object(forKey: Keys.alerts) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(alertsEnabled, forKey: Keys.alerts)
            Task { await sync() }
        }
    }
    @ObservationIgnored var account: Account?
    @ObservationIgnored var activityToken: String? {
        didSet { if activityToken != oldValue { Task { await sync() } } }
    }
    @ObservationIgnored var activityStartToken: String? {
        didSet { if activityStartToken != oldValue { Task { await sync() } } }
    }
    /// Random, made once per install: the relay keeps this phone's tokens under it.
    @ObservationIgnored let deviceId: String
    @ObservationIgnored private var deviceToken: String?
    @ObservationIgnored private let api = RelayAPI()
    @ObservationIgnored private var syncing = false
    @ObservationIgnored private var syncAgain = false

    private enum Keys {
        static let device = "pushDevice"
        static let alerts = "permissionAlerts"
    }

    init() {
        if let id = UserDefaults.standard.string(forKey: Keys.device) {
            deviceId = id
        } else {
            deviceId = UUID().uuidString.lowercased()
            UserDefaults.standard.set(deviceId, forKey: Keys.device)
        }
    }

    /// Asks once, after sign-in; afterwards the answer is in the Settings app.
    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        await refreshAuthorization()
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func received(deviceToken token: Data) {
        tokenProblem = nil
        deviceToken = PushDevice.hex(token)
        Task { await sync() }
    }

    func failed(_ error: Error) {
        tokenProblem = error.localizedDescription
    }

    /// Sends every token the relay should have now. One request at a time, the latest state last: the relay replaces
    /// what it had with each one, so an older request landing late would bring back a token that is gone.
    func sync() async {
        guard !syncing else {
            syncAgain = true
            return
        }
        syncing = true
        defer { syncing = false }
        repeat {
            syncAgain = false
            guard let account else { return }
            let device = PushDevice(
                device: deviceId, environment: Self.environment, alert: alertsEnabled ? deviceToken : nil, activity: activityToken,
                activityStart: activityStartToken)
            do {
                relayPushes = try await api.register(device, for: account) ?? false
            } catch {
                // Offline or refused: the next connection tries again.
            }
        } while syncAgain
    }

    func signOut(_ account: Account) async {
        try? await api.unregister(device: deviceId, for: account)
        relayPushes = nil
        self.account = nil
    }

    /// Development builds get their tokens from Apple's sandbox, TestFlight and the App Store from production.
    static var environment: PushDevice.Environment {
        #if targetEnvironment(simulator)
            return .sandbox
        #else
            guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
                let data = try? Data(contentsOf: url), let profile = String(data: data, encoding: .isoLatin1)
            else { return .production }
            let development = #"<key>aps-environment</key>\s*<string>development</string>"#
            return profile.range(of: development, options: .regularExpression) == nil ? .production : .sandbox
        #endif
    }
}
