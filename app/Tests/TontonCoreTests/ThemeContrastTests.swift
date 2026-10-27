import XCTest

@testable import TontonCore

final class ThemeContrastTests: XCTestCase {
    private let themes: [(String, ThemeColors)] = [
        ("Midnight", .midnight), ("Paper", .paper), ("Terminal", .terminal), ("Synthwave", .synthwave),
    ]

    func testContrastRatiosFollowWCAG() {
        XCTAssertEqual(Contrast.ratio(0x000000, 0xFFFFFF), 21, accuracy: 0.001)
        XCTAssertEqual(Contrast.ratio(0xFFFFFF, 0x000000), 21, accuracy: 0.001)
        XCTAssertEqual(Contrast.ratio(0x777777, 0x777777), 1, accuracy: 0.001)
        // The gray that just passes AA on white.
        XCTAssertEqual(Contrast.ratio(0x767676, 0xFFFFFF), 4.54, accuracy: 0.01)
    }

    func testMixingMovesEachChannel() {
        XCTAssertEqual(Contrast.mix(0x000000, 0xFFFFFF, 0), 0x000000)
        XCTAssertEqual(Contrast.mix(0x000000, 0xFFFFFF, 1), 0xFFFFFF)
        XCTAssertEqual(Contrast.mix(0x204060, 0x406080, 0.5), 0x305070)
        XCTAssertEqual(Contrast.mix(0x000000, 0xFFFFFF, 7), 0xFFFFFF)
    }

    func testRaisingStopsAsSoonAsTheColorReads() {
        // Already readable: unchanged.
        XCTAssertEqual(Contrast.raise(0x333333, toward: 0x000000, on: [0xFFFFFF], to: 7), 0x333333)
        let raised = Contrast.raise(0x999999, toward: 0x000000, on: [0xFFFFFF, 0xF0F0F0], to: 4.5)
        XCTAssertGreaterThanOrEqual(Contrast.ratio(raised, 0xF0F0F0), 4.5)
        XCTAssertLessThan(Contrast.ratio(raised, 0xF0F0F0), 5, "not darker than it needs")
        // Out of reach: as far as it goes.
        XCTAssertEqual(Contrast.raise(0xEEEEEE, toward: 0x888888, on: [0xFFFFFF], to: 21), 0x888888)
    }

    func testIncreaseContrastMakesSecondaryAndTertiaryTextReadableInEveryTheme() {
        for (name, colors) in themes {
            let strong = colors.increasedContrast
            for background in [colors.bg, colors.surface] {
                XCTAssertGreaterThanOrEqual(Contrast.ratio(strong.textDim, background), 7, name)
                XCTAssertGreaterThanOrEqual(Contrast.ratio(strong.textFaint, background), 4.5, name)
            }
            // The levels keep their order: faint stays fainter than dim, dim than the text.
            XCTAssertLessThan(Contrast.ratio(strong.textFaint, colors.bg), Contrast.ratio(strong.textDim, colors.bg), name)
            XCTAssertLessThan(Contrast.ratio(strong.textDim, colors.bg), Contrast.ratio(strong.text, colors.bg), name)
        }
    }

    func testIncreaseContrastOnlyTouchesTheTextThatNeedsIt() {
        for (name, colors) in themes {
            var strong = colors.increasedContrast
            XCTAssertNotEqual(strong.textFaint, colors.textFaint, "\(name): faint text is below 4.5:1 in every theme")
            (strong.textDim, strong.textFaint) = (colors.textDim, colors.textFaint)
            XCTAssertEqual(strong, colors, name)
        }
        // Terminal's dim green already reaches 7:1.
        XCTAssertEqual(ThemeColors.terminal.increasedContrast.textDim, ThemeColors.terminal.textDim)
    }

    func testIncreaseContrastLaysHairlinesThreeTimes() {
        XCTAssertEqual(ContrastLevel.standard.line(0.07), 0.07)
        XCTAssertEqual(ContrastLevel.increased.line(0), 0)
        XCTAssertEqual(ContrastLevel.increased.line(1), 1)
        XCTAssertEqual(ContrastLevel.increased.line(0.5), 0.875, accuracy: 0.0001)
        XCTAssertEqual(ContrastLevel.increased.line(0.07), 0.195, accuracy: 0.001)
        XCTAssertGreaterThan(ContrastLevel.increased.line(0.12), ContrastLevel.increased.line(0.07))
    }
}
