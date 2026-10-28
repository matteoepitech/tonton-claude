import XCTest

@testable import TontonCore

/// The plan the orchestrator proposes, as the notch reads it (shared/test/pool-plan.test.ts on the other side).
final class PoolPlanTests: XCTestCase {
    /// As the orchestrator's agent seals it (agent/test/pool-dispatch.test.ts).
    private let sealed = """
        {"kind":"plan_proposed","text":"The API, then the shop.","proposal":{"tasks":[
        {"id":"task0001api","machine":{"account":"memberacct01","machine":"machinestud1"}},
        {"id":"task0002web","machine":{"account":"memberacct01","machine":"machinestud1"}},
        {"id":"task0003e2e"},{"id":"../x"},"task",{"id":"task0004bad","machine":{"account":1}}]}}
        """

    private func state(events: [PoolState.Post<PoolEventBody>], dispatch: PoolDispatch? = nil) throws -> PoolState {
        let pool = try PoolVault(key: E2E.newKey())
        let task = { (id: String, title: String) in
            PoolItemWire(
                id: id, rev: 1, seq: 1, updatedAt: "x", ts: "x", account: "ana", session: "ses_lead",
                blob: try pool.seal(
                    PoolTask(
                        title: title, goal: nil, criteria: nil, area: nil, state: .todo, assignee: nil, dependsOn: nil, branch: nil,
                        summary: nil)))
        }
        let snapshot = PoolSnapshot(
            id: "pool00000001", createdAt: "x", paused: false, keyVersion: 1, info: try pool.seal(PoolInfo(name: "Shop")),
            members: [
                PoolMemberWire(
                    account: "memberacct01", role: .member, joinedAt: "x", profile: try pool.seal(PoolMemberProfile(name: "Bob")))
            ],
            sessions: [], tasks: [try task("task0001api", "API"), try task("task0002web", "Shop"), try task("task0003e2e", "Tests")],
            notes: nil, messages: [], events: [], own: nil, rules: nil, budgets: nil, audit: nil,
            orchestrator: PoolSessionRef(account: "ana", session: "ses_lead"))
        var state = PoolState(snapshot: snapshot, vault: pool)
        state.events = events
        state.dispatch = dispatch
        state.machines = [
            PoolState.Machine(
                account: "memberacct01", machine: "machinestud1", addedAt: "x",
                profile: PoolMachineProfile(name: "Studio", tool: "claude", capacity: 2, workdir: "~/p", mode: .edits, plan: "max_20x"),
                online: true, ready: true)
        ]
        return state
    }

    private func event(
        _ seq: Int, _ body: PoolEventBody, account: String = "ana", session: String? = "ses_lead"
    )
        -> PoolState.Post<
            PoolEventBody
        >
    {
        PoolState.Post(id: "e\(seq)", seq: seq, ts: "x", account: account, session: session, body: body)
    }

    func testAProposalKeepsTheEntriesOfTheRightShape() throws {
        let body = try JSONDecoder().decode(PoolEventBody.self, from: Data(sealed.utf8))
        XCTAssertEqual(body.proposal?.tasks.map(\.id), ["task0001api", "task0002web", "task0003e2e", "task0004bad"])
        XCTAssertEqual(body.proposal?.tasks.first?.machine, PoolMachineRef(account: "memberacct01", machine: "machinestud1"))
        XCTAssertNil(body.proposal?.tasks.last?.machine)
    }

    func testItWaitsForAnAdminUntilTheWorkStarts() throws {
        let proposed = try JSONDecoder().decode(PoolEventBody.self, from: Data(sealed.utf8))
        XCTAssertEqual(try state(events: [event(1, proposed)]).pendingPlan?.id, "e1")
        XCTAssertNil(try state(events: [event(1, proposed), event(2, PoolEventBody(kind: "plan_accepted"), session: nil)]).pendingPlan)
        XCTAssertNil(try state(events: [event(1, proposed), event(2, PoolEventBody(kind: "dispatched"), session: nil)]).pendingPlan)
        XCTAssertNil(try state(events: [event(1, proposed)], dispatch: PoolDispatch(on: true)).pendingPlan)
        // Only the orchestrator's.
        XCTAssertNil(try state(events: [event(1, proposed, account: "memberacct01", session: "ses_bob")]).pendingPlan)
    }

    func testItReadsAsEachMachineWithWhatItStarts() throws {
        let proposed = try JSONDecoder().decode(PoolEventBody.self, from: Data(sealed.utf8))
        let state = try state(events: [event(1, proposed)])
        let lanes = state.planLanes(try XCTUnwrap(proposed.proposal))
        XCTAssertEqual(lanes.map(\.id), ["machinestud1", "later"])
        XCTAssertEqual(lanes.first?.name, "Studio")
        XCTAssertEqual(lanes.first?.owner, "Bob")
        XCTAssertEqual(lanes.first?.plan, "Claude Max 20x")
        XCTAssertEqual(lanes.first?.tasks.map(\.id), ["task0001api", "task0002web"])
        // A task the pool does not have is left out.
        XCTAssertEqual(lanes.last?.tasks.map(\.id), ["task0003e2e"])
    }
}
