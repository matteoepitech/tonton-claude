import XCTest

@testable import TontonCore

final class NotchContentTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(_ id: String, _ status: SessionStatus, ago: TimeInterval = 0) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: id, title: nil, status: status, statusText: nil,
            agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: now, lastActivity: now - ago,
            lastMessage: nil)
    }

    func testTheSavedChoiceShowsAndThePickedOneIsSaved() {
        let sessions = NotchContentChoice(saved: .sessions)
        XCTAssertEqual(sessions.shown, .sessions)
        let music = sessions.picking(.music)
        XCTAssertEqual(music, NotchContentChoice(saved: .music))
        XCTAssertEqual(music.shown, .music)
        XCTAssertEqual(music.toggled(), NotchContentChoice(saved: .sessions))
        XCTAssertEqual(NotchContent.sessions.other, .music)
        XCTAssertEqual(NotchContent.music.other, .sessions)
    }

    /// A permission answered from Music mode must not take the music away for good.
    func testASessionOpenedFromMusicModeShowsUntilTheNotchCloses() {
        let visit = NotchContentChoice(saved: .music).openingSession()
        XCTAssertEqual(visit.shown, .sessions)
        XCTAssertEqual(visit.saved, .music)
        XCTAssertEqual(visit.closing(), NotchContentChoice(saved: .music))
        XCTAssertEqual(visit.closing().shown, .music)
    }

    func testThePickedChoiceEndsAVisit() {
        let visit = NotchContentChoice(saved: .music).openingSession()
        // ⌘M goes from what shows, the sessions, back to the music.
        XCTAssertEqual(visit.toggled(), NotchContentChoice(saved: .music))
        // Sessions picked on purpose stay after the notch closes.
        XCTAssertEqual(visit.picking(.sessions).closing().shown, .sessions)
    }

    func testOpeningASessionInSessionsModeChangesNothing() {
        let sessions = NotchContentChoice(saved: .sessions)
        XCTAssertEqual(sessions.openingSession(), sessions)
        XCTAssertFalse(NotchContentChoice(saved: .sessions, visiting: true).visiting)
    }

    func testOnlySessionsThatNeedTheUserOrFinishedUnseenKeepTheirPillInMusicMode() {
        let all = [
            session("asks", .permission), session("question", .waiting), session("broke", .error), session("works", .working),
            session("done", .idle), session("seen", .idle), session("starts", .starting),
        ]
        let unseen: Set = ["done", "works"]
        XCTAssertEqual(NotchContent.sessions.pills(all, finishedUnseen: unseen).map(\.id), all.map(\.id))
        XCTAssertEqual(NotchContent.music.pills(all, finishedUnseen: unseen).map(\.id), ["asks", "question", "broke", "done"])
        XCTAssertEqual(NotchContent.music.pills(all, finishedUnseen: []).map(\.id), ["asks", "question", "broke"])
    }

    func testPlayersAreOnlyAskedOnceMusicModeOpened() {
        XCTAssertFalse(NotchContent.listensToPlayers(musicOpened: false, showing: nil))
        XCTAssertFalse(NotchContent.listensToPlayers(musicOpened: false, showing: .sessions))
        XCTAssertTrue(NotchContent.listensToPlayers(musicOpened: false, showing: .music))
        // At launch, collapsed: opened before is enough.
        XCTAssertTrue(NotchContent.listensToPlayers(musicOpened: true, showing: nil))
    }

    func testMusicPlayingTakesTheWingsWhateverTheActivityDots() {
        let working = [session("works", .working)]
        XCTAssertEqual(NotchWings.pick(working, content: .music, playing: true, dots: false, liveActivity: false), .music)
        XCTAssertEqual(NotchWings.pick([], content: .music, playing: true, dots: true, liveActivity: true), .music)
        // A working session doesn't push the music aside.
        XCTAssertEqual(NotchWings.pick(working, content: .music, playing: true, dots: true, liveActivity: true), .music)
    }

    func testASessionThatNeedsTheUserTakesTheWingsBackFromTheMusic() {
        let asking = session("asks", .permission)
        let sessions = [session("works", .working), asking]
        XCTAssertEqual(NotchWings.pick(sessions, content: .music, playing: true, dots: false, liveActivity: true), .live(asking))
        // Without live activity, the music stays: the banner and the pill bring the session.
        XCTAssertEqual(NotchWings.pick(sessions, content: .music, playing: true, dots: true, liveActivity: false), .music)
    }

    func testNothingPlayingLeavesTheUsualWings() {
        let works = session("works", .working)
        for content in NotchContent.allCases {
            XCTAssertEqual(NotchWings.pick([works], content: content, playing: false, dots: false, liveActivity: true), .live(works))
            XCTAssertEqual(NotchWings.pick([works], content: content, playing: false, dots: true, liveActivity: false), .dots)
            XCTAssertEqual(NotchWings.pick([works], content: content, playing: false, dots: false, liveActivity: false), .hidden)
            XCTAssertEqual(NotchWings.pick([], content: content, playing: false, dots: true, liveActivity: true), .hidden)
        }
        // Sessions mode ignores the music.
        XCTAssertEqual(NotchWings.pick([works], content: .sessions, playing: true, dots: true, liveActivity: false), .dots)
        XCTAssertEqual(NotchWings.pick([works], content: .sessions, playing: true, dots: false, liveActivity: true).session, works)
        XCTAssertNil(NotchWings.music.session)
    }
}
