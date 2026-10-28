import Foundation

/// A deterministic, fixed-step solo arena. No session, permission or network APIs enter the simulation.
public struct RPGCombat: Codable, Equatable, Sendable {
    public enum Phase: String, Codable, Sendable { case playing, paused, won, lost }
    public enum EnemyKind: String, Codable, Sendable { case chaser, charger, boss }
    public struct Enemy: Codable, Equatable, Identifiable, Sendable {
        public let id: Int
        public let kind: EnemyKind
        public var x: Double
        public var y: Double
        public var health: Double
        public var cooldown: Double = 1
        public var warning: Double = 0
        public var targetX: Double = 0
        public var targetY: Double = 0
    }
    public struct Input: Sendable {
        public var x = 0.0
        public var y = 0.0
        public var attack = false
        public var ability = false
        public init(x: Double = 0, y: Double = 0, attack: Bool = false, ability: Bool = false) {
            self.x = x; self.y = y; self.attack = attack; self.ability = ability
        }
    }
    public let id: String
    public let startedAt: String
    public private(set) var phase: Phase = .paused
    public private(set) var wave = 1
    public private(set) var x = 320.0
    public private(set) var y = 200.0
    public private(set) var health: Double
    public private(set) var enemies: [Enemy] = []
    public private(set) var attackCooldown = 0.0
    public private(set) var abilityCooldown = 0.0
    public private(set) var hitFlash = 0.0
    public private(set) var elapsed = 0.0
    public var claimed = false
    public let maxHealth: Double
    public let damage: Double
    public let speed: Double
    private var accumulator = 0.0
    private var seed: UInt64
    public static let width = 640.0
    public static let height = 400.0

    public init(
        hero: RPG.State, id: String = UUID().uuidString, startedAt: String = ISO8601DateFormatter().string(from: Date()), seed: UInt64 = 1
    ) {
        self.id = id; self.startedAt = startedAt; self.seed = seed
        let stats = RPG.Stats(hero: hero)
        maxHealth = stats.health; health = stats.health; damage = stats.attack; speed = stats.movement
        spawn()
    }
    public mutating func pause() { if phase == .playing { phase = .paused }; accumulator = 0 }
    public mutating func resume() { if phase == .paused { phase = .playing } }
    /// Hidden or unfocused windows do not call this. Bound catch-up after a stalled frame to prevent teleporting.
    public mutating func advance(_ seconds: Double, input: Input) {
        guard phase == .playing, seconds.isFinite, seconds > 0 else { return }
        accumulator += min(seconds, 0.25)
        while accumulator + 0.000_000_1 >= 1 / 60 && phase == .playing {
            accumulator -= 1 / 60
            step(1 / 60, input)
        }
    }
    private mutating func random() -> Double {
        seed = seed &* 6_364_136_223_846_793_005 &+ 1
        return Double(seed >> 32) / 4_294_967_296
    }
    private mutating func spawn() {
        enemies = []
        for index in 0..<(wave == 3 ? 1 : wave + 2) {
            let kind: EnemyKind = wave == 3 ? .boss : wave == 2 && index % 2 == 0 ? .charger : .chaser
            let ex = index % 2 == 0 ? 35.0 : 605.0
            enemies.append(
                Enemy(
                    id: wave * 10 + index, kind: kind, x: ex, y: 30 + random() * 340,
                    health: kind == .boss ? 180 : kind == .charger ? 40 : 30))
        }
    }
    private mutating func step(_ dt: Double, _ input: Input) {
        elapsed += dt
        attackCooldown = max(0, attackCooldown - dt)
        abilityCooldown = max(0, abilityCooldown - dt)
        hitFlash = max(0, hitFlash - dt)
        let dx = input.x.isFinite ? min(1, max(-1, input.x)) : 0
        let dy = input.y.isFinite ? min(1, max(-1, input.y)) : 0
        let length = max(1, hypot(dx, dy))
        x = min(624, max(16, x + dx / length * speed * dt))
        y = min(384, max(16, y + dy / length * speed * dt))
        if input.attack && attackCooldown == 0 {
            attackCooldown = 0.4
            if let index = enemies.indices.filter({ hypot(enemies[$0].x - x, enemies[$0].y - y) <= 68 })
                .min(by: { hypot(enemies[$0].x - x, enemies[$0].y - y) < hypot(enemies[$1].x - x, enemies[$1].y - y) })
            {
                enemies[index].health -= damage
            }
        }
        if input.ability && abilityCooldown == 0 {
            abilityCooldown = 5
            for index in enemies.indices where hypot(enemies[index].x - x, enemies[index].y - y) <= 130 {
                enemies[index].health -= damage * 2
            }
        }
        enemies.removeAll { $0.health <= 0 }
        for index in enemies.indices {
            var enemy = enemies[index]
            let distance = max(1, hypot(x - enemy.x, y - enemy.y))
            enemy.cooldown = max(0, enemy.cooldown - dt)
            if enemy.warning > 0 {
                enemy.warning = max(0, enemy.warning - dt)
                if enemy.warning == 0 {
                    if hypot(x - enemy.targetX, y - enemy.targetY) < (enemy.kind == .boss ? 70 : 40) {
                        health -= enemy.kind == .boss ? 22 : 12; hitFlash = 0.2
                    }
                    if enemy.kind == .charger { enemy.x = enemy.targetX; enemy.y = enemy.targetY }
                    enemy.cooldown = enemy.kind == .boss && enemy.health < 90 ? 1.2 : 2.5
                }
            } else if enemy.kind != .chaser && enemy.cooldown == 0 {
                enemy.targetX = x; enemy.targetY = y
                enemy.warning = enemy.kind == .boss ? 1.0 : 0.7
            } else {
                let pace = enemy.kind == .boss ? 35.0 : 48.0
                if distance > 24 { enemy.x += (x - enemy.x) / distance * pace * dt; enemy.y += (y - enemy.y) / distance * pace * dt }
                if enemy.kind == .chaser && distance < 28 && enemy.cooldown == 0 {
                    health -= 8; hitFlash = 0.2; enemy.cooldown = 1
                }
            }
            enemies[index] = enemy
        }
        health = max(0, health)
        if health == 0 { phase = .lost; return }
        if enemies.isEmpty {
            if wave == 3 { phase = .won } else { wave += 1; health = min(maxHealth, health + 20); spawn() }
        }
    }
    public func rewards() -> [RPG.Reward] {
        guard phase == .won else { return [] }
        return (1...3).map { wave in
            RPG.Reward(kind: wave == 3 ? .boss : .encounter, source: "arena-v1/\(id)/\(wave)", at: startedAt)
        }
    }
}
