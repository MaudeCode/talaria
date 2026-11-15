import XCTest
@testable import TalariaKit

final class StreamingWordDrainTests: XCTestCase {
    // MARK: - unitCount

    func testUnitCountEmptyTextIsZero() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: ""), 0)
    }

    func testUnitCountTextWithoutWhitespaceIsOneUnit() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "chunk-0chunk-1chunk-2"), 1)
    }

    func testUnitCountWhitespaceOnlyTextIsOneUnit() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "  \n\t "), 1)
    }

    func testUnitCountCountsWordsWithTrailingWhitespace() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "alpha beta gamma"), 3)
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "alpha beta gamma "), 3)
    }

    func testUnitCountLeadingWhitespaceAttachesToFirstUnit() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "  alpha beta"), 2)
    }

    func testUnitCountTreatsConsecutiveWhitespaceAsOneSeparator() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "alpha  \n\n beta\t\tgamma"), 3)
    }

    func testUnitCountHandlesGraphemeClusters() {
        XCTAssertEqual(StreamingWordDrain.unitCount(in: "👩‍👩‍👧‍👦 🇫🇷 café"), 3)
    }

    // MARK: - splitAtUnitBoundary

    func testSplitAtUnitBoundaryRoundTripsForEveryCount() {
        let text = "  alpha beta\n\ngamma  delta epsilon"
        let unitCount = StreamingWordDrain.unitCount(in: text)
        for count in 0...(unitCount + 2) {
            let (head, tail) = StreamingWordDrain.splitAtUnitBoundary(text, unitCount: count)
            XCTAssertEqual(head + tail, text, "head + tail must reproduce input for count \(count)")
        }
    }

    func testSplitAtUnitBoundaryZeroCountReturnsEverythingInTail() {
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary("alpha beta", unitCount: 0)
        XCTAssertEqual(head, "")
        XCTAssertEqual(tail, "alpha beta")
    }

    func testSplitAtUnitBoundaryTakesWordsWithTrailingWhitespace() {
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary("alpha  beta gamma", unitCount: 1)
        XCTAssertEqual(head, "alpha  ")
        XCTAssertEqual(tail, "beta gamma")
    }

    func testSplitAtUnitBoundaryCountBeyondBacklogReturnsEverythingInHead() {
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary("alpha beta", unitCount: 5)
        XCTAssertEqual(head, "alpha beta")
        XCTAssertEqual(tail, "")
    }

    func testSplitAtUnitBoundaryNeverSplitsGraphemeClusters() {
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary("👩‍👩‍👧‍👦 x", unitCount: 1)
        XCTAssertEqual(head, "👩‍👩‍👧‍👦 ")
        XCTAssertEqual(tail, "x")
    }

    func testSplitAtUnitBoundaryKeepsCombiningMarksWithBaseCharacter() {
        // "e" + U+0301 combine into one grapheme; the boundary after "café" must
        // include the combining mark in head.
        let text = "cafe\u{301} au lait"
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary(text, unitCount: 1)
        XCTAssertEqual(head, "cafe\u{301} ")
        XCTAssertEqual(tail, "au lait")
    }

    func testSplitAtUnitBoundaryLeadingWhitespaceStaysWithFirstUnit() {
        let (head, tail) = StreamingWordDrain.splitAtUnitBoundary("  alpha beta", unitCount: 1)
        XCTAssertEqual(head, "  alpha ")
        XCTAssertEqual(tail, "beta")
    }
}
