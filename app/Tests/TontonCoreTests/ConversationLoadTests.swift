import XCTest

@testable import TontonCore

final class ConversationLoadTests: XCTestCase {
    private let entry = Entry(id: "a1", ts: "2026-10-27T10:00:00Z", kind: .assistant, text: "Done")

    func testAPartialHistoryDecodesApartFromTheWholeOne() throws {
        let decode = { (json: String) in try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) }
        guard case .recentHistory("s1", let recent) = try decode(#"{"t":"history","sessionId":"s1","entries":[],"partial":true}"#),
            case .history("s1", let whole) = try decode(#"{"t":"history","sessionId":"s1","entries":[]}"#),
            case .history = try decode(#"{"t":"history","sessionId":"s1","entries":[],"partial":false}"#)
        else { return XCTFail("wrong cases") }
        XCTAssertEqual(recent.count + whole.count, 0)
    }

    func testTheChatSaysWhileTheConversationIsOnItsWay() {
        let state = { (relay: Bool, reachable: Bool, entries: [Entry]?, partial: Bool, local: Int) in
            ConversationLoad.state(relaySession: relay, reachable: reachable, relayEntries: entries, partial: partial, localEntries: local)
        }
        XCTAssertEqual(state(true, true, nil, false, 0), .loading)
        XCTAssertEqual(state(true, true, [entry], true, 0), .loadingEarlier)
        XCTAssertEqual(state(true, true, [entry], false, 0), .loaded)
        // An empty history is a loaded one.
        XCTAssertEqual(state(true, true, [], false, 0), .loaded)
        // This Mac's transcript shows until the relay's copy comes.
        XCTAssertEqual(state(true, true, nil, false, 12), .loaded)
        XCTAssertEqual(state(true, true, [entry], true, 12), .loaded)
        // Sessions only on this Mac, and a relay out of reach, have nothing to wait for.
        XCTAssertEqual(state(false, true, nil, false, 0), .loaded)
        XCTAssertEqual(state(true, false, nil, false, 0), .loaded)
    }

    func testTheLatestEntriesNeverHideAWholeConversation() {
        XCTAssertTrue(ConversationLoad.takesRecent(current: nil, partial: false))
        XCTAssertTrue(ConversationLoad.takesRecent(current: [entry], partial: true))
        // After a reconnection: what shows stays until the whole history comes.
        XCTAssertFalse(ConversationLoad.takesRecent(current: [entry], partial: false))
        XCTAssertFalse(ConversationLoad.takesRecent(current: [], partial: false))
    }
}
