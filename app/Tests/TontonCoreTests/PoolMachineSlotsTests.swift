import XCTest

@testable import TontonCore

final class PoolMachineSlotsTests: XCTestCase {
    private func task(_ id: String, _ state: PoolTaskState, machine: PoolMachineRef?, _ pool: PoolVault) throws -> PoolItemWire {
        var task = PoolTask(title: id, state: state)
        task.machine = machine
        return PoolItemWire(id: id, rev: 1, seq: nil, updatedAt: "x", ts: nil, account: "a1", session: nil, blob: try pool.seal(task))
    }

    func testAMachineRunsTheTasksDispatchedToItThatAreNotDone() throws {
        let pool = try PoolVault(key: E2E.newKey())
        let mine = PoolMachineRef(account: "a1", machine: "m1")
        let other = PoolMachineRef(account: "a1", machine: "m2")
        let tasks = [
            try task("working", .inProgress, machine: mine, pool),
            try task("starting", .assigned, machine: mine, pool),
            try task("stuck", .blocked, machine: mine, pool),
            try task("finished", .done, machine: mine, pool),
            try task("in review", .review, machine: mine, pool),
            try task("elsewhere", .inProgress, machine: other, pool),
            try task("by hand", .inProgress, machine: nil, pool),
        ]
        let snapshot = PoolSnapshot(
            id: "p", createdAt: "x", paused: false, keyVersion: 1, info: try pool.seal(PoolInfo(name: "Hack")), members: [], sessions: [],
            tasks: tasks, notes: nil, messages: [], events: [], own: nil, rules: nil, budgets: nil, audit: nil, orchestrator: nil)
        let state = PoolState(snapshot: snapshot, vault: pool)
        XCTAssertEqual(state.slots(of: mine).map(\.id), ["working", "starting", "stuck"])
        XCTAssertEqual(state.slots(of: other).map(\.id), ["elsewhere"])
    }

    func testEveryModeSaysWhatPassesAndFullWarns() {
        XCTAssertEqual(PoolMachineMode.allCases.count, 3)
        for mode in PoolMachineMode.allCases {
            XCTAssertFalse(mode.label.isEmpty)
            XCTAssertFalse(mode.detail.isEmpty)
        }
        XCTAssertTrue(PoolMachineMode.full.detail.contains("never one with your own files"))
    }
}
