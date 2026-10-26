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
}
