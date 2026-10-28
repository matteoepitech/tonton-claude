import CryptoKit
import XCTest

@testable import TontonCore

/// Pool machines (docs/pool-autopilot.md), read as the relay sends them and as the client core seals them.
final class PoolMachineTests: XCTestCase {
    private let decode = { (json: String) in try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) }

    func testTheFormGivesAProfileOnlyAnAgentCanRun() throws {
        var form = PoolMachineForm(tool: .openCode)
        XCTAssertEqual(form.mode, .ask)
        XCTAssertEqual(form.capacity, 1)
        XCTAssertEqual(form.takes, .simple)
        form.areas = ["Back, front", "back", " "]
        form.workdir = " /srv/pool "
        XCTAssertEqual(
            form.profile(name: "Studio"),
            PoolMachineProfile(
                name: "Studio", tool: "opencode", capacity: 1, workdir: "/srv/pool", mode: .ask, takes: "simple", areas: ["back", "front"]))
        form.capacity = 9
        XCTAssertEqual(form.problem, .capacity)
        XCTAssertNil(form.profile(name: nil))
        form.capacity = 8
        for bad in ["pool", "./pool", "/", "~", "~/", "/srv/../etc", "C:", "/a\nb"] {
            form.workdir = bad
            XCTAssertEqual(form.problem, .workdir, bad)
        }
        for good in ["/srv/pool", "~/pool", #"C:\pool"#, "D:/work"] { XCTAssertTrue(PoolMachineProfile.isWorkdir(good), good) }
    }

    /// As the website's form (shared/pool-model.ts, modelPolicyFromForm): what is left as the default is not sealed.
    func testTheFormSealsTheModelsTheOwnerChose() throws {
        var form = PoolMachineForm()
        XCTAssertEqual(form.allowed, Set(PoolModelTier.allCases))
        XCTAssertEqual(form.escalations, 1)
        form.models = [.light: " haiku ", .balanced: ""]
        XCTAssertNil(form.modelPolicy)
        XCTAssertNil(form.profile(name: nil)?.models)
        form.lock = .balanced
        form.allowed = [.strong, .light]
        form.models[.balanced] = "anthropic/claude-sonnet-4-5"
        form.escalations = 0
        let policy = PoolModelPolicy(
            lock: "balanced", allowed: ["light", "strong"], tiers: ["balanced": "anthropic/claude-sonnet-4-5"], escalations: 0)
        XCTAssertEqual(form.modelPolicy, policy)
        XCTAssertEqual(form.profile(name: nil)?.models, policy)
        let json = try XCTUnwrap(String(data: try JSONEncoder().encode(policy), encoding: .utf8))
        XCTAssertTrue(json.contains(#""allowed":["light","strong"]"#), json)
        form.allowed = []
        XCTAssertEqual(form.problem, .tiers)
        form.allowed = [.light]
        form.models[.strong] = "opus --dangerously-skip-permissions"
        XCTAssertEqual(form.problem, .model)
        XCTAssertNil(form.profile(name: nil))
        for ok in ["sonnet", "claude-opus-4-5[1m]", "ollama/qwen3:32b"] { XCTAssertTrue(PoolModelTier.isModel(ok), ok) }
        for bad in ["", "a/b/c", "$(id)", String(repeating: "x", count: 101)] { XCTAssertFalse(PoolModelTier.isModel(bad), bad) }
    }

    func testAProfileAnotherMemberSealedReadsAsTheClientCoreReadsIt() throws {
        let pool = try PoolVault(key: E2E.newKey())
        let profile = PoolMachineProfile(name: "Studio", tool: "claude", capacity: 2, workdir: "~/pool", mode: .full, areas: ["back"])
        XCTAssertEqual(pool.open(try pool.seal(profile), as: PoolMachineProfile.self), profile)
        // What the agent could not run is no profile at all; extra fields and wrong optional ones are left out.
        let read = { (json: String) in try? JSONDecoder().decode(PoolMachineProfile.self, from: Data(json.utf8)) }
        let base = #""tool":"claude","capacity":2,"workdir":"~/pool","mode":"edits""#
        XCTAssertNil(read(#"{"tool":"claude","capacity":0,"workdir":"~/pool","mode":"edits"}"#))
        XCTAssertNil(read(#"{"tool":"claude","capacity":2,"workdir":"~/pool","mode":"root"}"#))
        XCTAssertNil(read(#"{"tool":"claude","capacity":2,"workdir":"../x","mode":"edits"}"#))
        XCTAssertNil(read(#"{"tool":"cursor","capacity":2,"workdir":"~/pool","mode":"edits"}"#))
        XCTAssertEqual(
            read("{\(base),\"takes\":\"huge\",\"areas\":[\"front\",\"\"],\"name\":5,\"extra\":1}"),
            PoolMachineProfile(tool: "claude", capacity: 2, workdir: "~/pool", mode: .edits, areas: ["front"]))
    }

    func testTheMachineMessagesDecodeAsTheRelaySendsThem() throws {
        let machine = #"{"account":"acct","machine":"machine00001","addedAt":"x","profile":"sealed","online":true,"ready":false}"#
        guard case .pool(.machine("p", let wire)) = try decode(#"{"t":"pool_machine","poolId":"p","machine":\#(machine)}"#) else {
            return XCTFail("not a machine")
        }
        XCTAssertEqual(wire.machine, "machine00001")
        XCTAssertFalse(wire.ready)
        XCTAssertNil(wire.stopped)
        let stopped =
            #"{"t":"pool_machine","poolId":"p","machine":{"account":"a","machine":"m","addedAt":"x","profile":null,"online":true,"ready":true,"stopped":true}}"#
        guard case .pool(.machine(_, let halted)) = try decode(stopped) else { return XCTFail("not a stopped machine") }
        XCTAssertEqual(halted.stopped, true)
        guard
            case .pool(.machineLeft("p", "acct", "machine00001")) = try decode(
                #"{"t":"pool_machine_left","poolId":"p","account":"acct","machine":"machine00001"}"#)
        else { return XCTFail("not a machine leaving") }
        let lead = #"{"t":"pool_orchestrator","poolId":"p","orchestrator":null,"machine":{"account":"acct","machine":"machine00001"}}"#
        guard case .pool(.orchestrator("p", nil, let ref)) = try decode(lead) else { return XCTFail("not an orchestrator") }
        XCTAssertEqual(ref, PoolMachineRef(account: "acct", machine: "machine00001"))
        let dispatch =
            #"{"t":"pool_dispatch","poolId":"p","dispatch":{"rev":1,"updatedAt":"x","account":"acct","session":null,"machine":"m1","blob":"b"}}"#
        guard case .pool(.dispatch("p", let item)) = try decode(dispatch) else { return XCTFail("not a dispatch") }
        XCTAssertEqual(item.machine, "m1")
        // A machine the app does not know the shape of is no message, as with every pool message.
        guard case .unknown = try decode(#"{"t":"pool_machine","poolId":"p","machine":{"account":"acct"}}"#) else {
            return XCTFail("a wrong shape decoded")
        }
    }

    func testThePoolStateFollowsItsMachinesAndTheDispatch() throws {
        let pool = try PoolVault(key: E2E.newKey())
        let profile = PoolMachineProfile(tool: "claude", capacity: 2, workdir: "~/pool", mode: .edits)
        let wire = { (ready: Bool) in
            PoolMachineWire(
                account: "bob", machine: "machine00001", addedAt: "x", profile: try pool.seal(profile), online: true, ready: ready)
        }
        let older = PoolSnapshot(
            id: "p", createdAt: "x", paused: false, keyVersion: 1, info: try pool.seal(PoolInfo(name: "Hack")), members: [], sessions: [],
            tasks: [], notes: nil, messages: [], events: [], own: nil, rules: nil, budgets: nil, audit: nil, orchestrator: nil)
        XCTAssertNil(PoolState(snapshot: older, vault: pool).machines)

        var snapshot = older
        snapshot.machines = [try wire(false)]
        snapshot.dispatch = PoolItemWire(
            id: nil, rev: 1, seq: nil, updatedAt: "x", ts: nil, account: "ana", session: nil, blob: try pool.seal(PoolDispatch(on: true)))
        var state = PoolState(snapshot: snapshot, vault: pool)
        XCTAssertEqual(state.machines?.first?.profile, profile)
        XCTAssertEqual(state.dispatch, PoolDispatch(on: true))
        _ = state.apply(.machine(poolId: "p", try wire(true)), vault: pool)
        XCTAssertEqual(state.machines?.map(\.ready), [true])
        XCTAssertEqual(state.machines?.map(\.stopped), [false])
        var halted = try wire(true)
        halted.stopped = true
        _ = state.apply(.machine(poolId: "p", halted), vault: pool)
        XCTAssertEqual(state.machines?.map(\.stopped), [true])
        _ = state.apply(.machine(poolId: "p", try wire(true)), vault: pool)
        XCTAssertEqual(state.machines(of: "bob").count, 1)
        _ = state.apply(.orchestrator(poolId: "p", nil, machine: PoolMachineRef(account: "bob", machine: "machine00001")), vault: pool)
        XCTAssertEqual(state.orchestratorMachine?.machine, "machine00001")
        _ = state.apply(.machineLeft(poolId: "p", account: "bob", machine: "machine00001"), vault: pool)
        XCTAssertEqual(state.machines, [])
        XCTAssertNil(state.orchestratorMachine)

        _ = state.apply(.machine(poolId: "p", try wire(true)), vault: pool)
        _ = state.apply(.memberLeft(poolId: "p", account: "bob"), vault: pool)
        XCTAssertEqual(state.machines, [])
    }

    func testATaskNamesItsMachineAndItsAttempts() throws {
        let json = #"{"title":"API","state":"assigned","machine":{"account":"acct","machine":"m1"},"attempts":2}"#
        let task = try JSONDecoder().decode(PoolTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.machine, PoolMachineRef(account: "acct", machine: "m1"))
        XCTAssertEqual(task.attempts, 2)
        let session =
            #"{"account":"a","session":"s","joinedAt":"x","profile":null,"online":true,"ready":true,"machine":"m1"}"#
        XCTAssertEqual(try JSONDecoder().decode(PoolSessionWire.self, from: Data(session.utf8)).machine, "m1")
    }

    func testTheModelsOfAMachineAndATaskAreKeptWhenWrittenBack() throws {
        let read = { (json: String) in try JSONDecoder().decode(PoolMachineProfile.self, from: Data(json.utf8)) }
        let base = #""tool":"claude","capacity":1,"workdir":"~/pool","mode":"edits""#
        let profile = try read("{\(base),\"models\":{\"allowed\":[\"light\",\"balanced\"],\"escalations\":1}}")
        XCTAssertEqual(profile.models, PoolModelPolicy(allowed: ["light", "balanced"], escalations: 1))
        XCTAssertEqual(try JSONDecoder().decode(PoolMachineProfile.self, from: JSONEncoder().encode(profile)), profile)
        // A policy the app cannot read leaves the profile as it is, without one.
        XCTAssertNil(try read("{\(base),\"models\":\"opus\"}").models)

        let json =
            #"{"title":"API","state":"in_progress","model":"strong","setbacks":1,"route":{"tier":"strong","model":"opus","escalated":1}}"#
        let task = try JSONDecoder().decode(PoolTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.model, "strong")
        XCTAssertEqual(task.setbacks, 1)
        XCTAssertEqual(task.route?.escalated, 1)
        XCTAssertEqual(try JSONDecoder().decode(PoolTask.self, from: JSONEncoder().encode(task)), task)
    }

    func testOnlyAgentsThatRunPoolMachinesAreOffered() {
        let machine = { (version: String?) in
            MachineInfo(
                id: "m", name: "PC", platform: nil, createdAt: Date(), lastSeen: nil, online: true, agentVersion: version, health: nil)
        }
        XCTAssertFalse(machine("0.8.0").runsPoolMachines)
        XCTAssertFalse(machine(nil).runsPoolMachines)
        XCTAssertTrue(machine("0.9.0").runsPoolMachines)
        XCTAssertTrue(machine("0.0.0").runsPoolMachines)
    }

    private struct AutoTable: Decodable {
        struct Health: Decodable {
            let tools: [String]
            let plan: String?
            let memoryTotal: Double
        }
        struct Machine: Decodable {
            let name: String
            let health: Health?
        }
        struct Pool: Decodable {
            let id: String
            let name: String?
        }
        struct Case: Decodable {
            let name: String
            let machine: Machine
            let pool: Pool
            let mode: PoolMachineMode
            let profile: PoolMachineProfile?
        }
        let cases: [Case]
    }

    /// The same table as shared/test/pool-auto-profile.test.ts: a machine joins with what its agent reports, from the
    /// Mac app as from the website.
    func testAMachineJoinsAPoolOnItsOwn() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/test/pool-auto-profile.json")
        let table = try JSONDecoder().decode(AutoTable.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(table.cases.count, 5)
        for item in table.cases {
            let health = item.machine.health.map {
                MachineHealth(
                    cpu: 0, memoryUsed: 0, memoryTotal: $0.memoryTotal, battery: nil, wake: nil, tools: $0.tools, plan: $0.plan, at: "x")
            }
            let profile = PoolMachineProfile.automatic(
                name: item.machine.name, health: health, poolId: item.pool.id, poolName: item.pool.name, mode: item.mode)
            XCTAssertEqual(profile, item.profile, item.name)
            if let profile {
                XCTAssertEqual(try JSONDecoder().decode(PoolMachineProfile.self, from: JSONEncoder().encode(profile)), profile, item.name)
            }
        }
    }

    func testWhatEachMachineBrings() {
        let profile = { (tool: String, plan: String?) in
            PoolMachineProfile(tool: tool, capacity: 1, workdir: "~/p", mode: .edits, plan: plan)
        }
        XCTAssertEqual(profile("claude", "max_20x").planLabel, "Claude Max 20x")
        XCTAssertEqual(profile("claude", "pro").planLabel, "Claude Pro")
        XCTAssertEqual(profile("claude", nil).planLabel, "Claude Code")
        XCTAssertEqual(profile("claude", "max_50x").planLabel, "Claude Code")
        XCTAssertEqual(profile("opencode", nil).planLabel, "OpenCode")
        // A plan that is not a plan's name is dropped when read.
        let sealed = #"{"tool":"claude","capacity":1,"workdir":"~/p","mode":"edits","plan":"<b>max</b>"}"#
        XCTAssertNil(try JSONDecoder().decode(PoolMachineProfile.self, from: Data(sealed.utf8)).plan)
    }
}
