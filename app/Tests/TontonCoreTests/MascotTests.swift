import XCTest

@testable import TontonCore

final class MascotTests: XCTestCase {
    func testEveryFrameIsASquareOfKnownPixels() {
        for pose in [Mascot.Pose.typing, .sleeping, .raisingHand] {
            let frames = Mascot.frames(pose)
            XCTAssertGreaterThan(frames.count, 1, "\(pose) should move")
            for frame in frames {
                XCTAssertEqual(frame.count, Mascot.size)
                for row in frame {
                    XCTAssertEqual(row.count, Mascot.size, row)
                    XCTAssertTrue(row.allSatisfy { "#o-hkz.".contains($0) }, row)
                }
            }
        }
    }

    func testThePoseFollowsTheSession() {
        XCTAssertEqual(Mascot.pose(for: .working), .typing)
        XCTAssertEqual(Mascot.pose(for: .permission), .raisingHand)
        XCTAssertEqual(Mascot.pose(for: .waiting), .raisingHand)
        XCTAssertEqual(Mascot.pose(for: .idle), .sleeping)
    }

    func testEveryPoseSitsInTheMiddleOfItsSquare() {
        // Sleeping and waving leave four empty rows below him: without the shift he sits at the top of the notch.
        XCTAssertEqual(Mascot.centering(.sleeping).y, 2)
        XCTAssertEqual(Mascot.centering(.raisingHand).y, 2)
        for pose in [Mascot.Pose.typing, .sleeping, .raisingHand] {
            let shift = Mascot.centering(pose)
            for frame in Mascot.frames(pose) {
                let rows = frame.indices.filter { frame[$0].contains { $0 != "." } }
                let columns = (0..<Mascot.size).filter { x in frame.contains { Array($0)[x] != "." } }
                // What he draws stays inside the square once moved.
                XCTAssertGreaterThanOrEqual((rows.min() ?? 0) + shift.y, 0)
                XCTAssertLessThan((rows.max() ?? 0) + shift.y, Mascot.size)
                XCTAssertGreaterThanOrEqual((columns.min() ?? 0) + shift.x, 0)
                XCTAssertLessThan((columns.max() ?? 0) + shift.x, Mascot.size)
            }
        }
    }
}
