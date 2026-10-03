import XCTest
@testable import TalariaKit

final class ContextWindowIndicatorTests: XCTestCase {
    func testPresentationProvidesNonInteractivePlaceholderBeforeSnapshotLoads() {
        let presentation = ContextWindowIndicatorPresentation(snapshot: nil)

        XCTAssertEqual(presentation.percentageLabel, "–")
        XCTAssertFalse(presentation.isInteractive)
        XCTAssertNil(presentation.percentage)
    }

    private func makeSnapshot(
        used: Int? = nil,
        window: Int? = nil,
        percent: Int? = nil,
        thresholdTokens: Int? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        estimatedCost: Double? = nil
    ) -> ContextWindowSnapshot {
        ContextWindowSnapshot(
            contextUsedTokens: used,
            contextWindowTokens: window,
            contextUsagePercent: percent,
            thresholdTokens: thresholdTokens,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            estimatedCost: estimatedCost
        )
    }

    func testPresentationShowsTheServerPercent() {
        let presentation = ContextWindowIndicatorPresentation(snapshot: makeSnapshot(used: 64_000, window: 128_000, percent: 50))

        XCTAssertEqual(presentation.percentageLabel, "50")
        XCTAssertTrue(presentation.isInteractive)
        XCTAssertEqual(presentation.percentage, 0.5)
    }

    func testPresentationLabelIsTheServerIntegerWithoutFloatingPointLoss() {
        XCTAssertEqual(ContextWindowIndicatorPresentation(snapshot: makeSnapshot(used: 37_120, window: 128_000, percent: 29)).percentageLabel, "29")
    }

    func testPresentationShowsNoPercentWithoutTheServerPercent() {
        // A cumulative input total and a known window are not a ring value; only the server's percent is.
        let presentation = ContextWindowIndicatorPresentation(snapshot: makeSnapshot(window: 200_000, inputTokens: 900_000))

        XCTAssertEqual(presentation.percentageLabel, "–")
        XCTAssertFalse(presentation.isInteractive)
        XCTAssertNil(presentation.percentage)
    }

    func testSnapshotDecodesTheServerFiguresFromASession() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s","input_tokens":900000,"context_length":128000,"last_prompt_tokens":64000,"threshold_tokens":100000,"context_used_tokens":64000,"context_window_tokens":128000,"context_usage_percent":50,"context_threshold_percent":78}"#.utf8))

        XCTAssertEqual(ContextWindowSnapshot(session: session), ContextWindowSnapshot(
            contextUsedTokens: 64_000,
            contextWindowTokens: 128_000,
            contextUsagePercent: 50,
            contextThresholdPercent: 78,
            thresholdTokens: 100_000,
            inputTokens: 900_000,
            outputTokens: nil,
            estimatedCost: nil
        ))
    }

    func testTokensLabelFormatsK() {
        let snapshot = makeSnapshot(used: 12_345, window: 128_000)

        XCTAssertEqual(ContextWindowFormatter.tokensLabel(from: snapshot), "12.3K / 128.0K")
    }

    func testTokensLabelFormatsM() {
        let snapshot = makeSnapshot(used: 1_500_000, window: 2_000_000)

        XCTAssertEqual(ContextWindowFormatter.tokensLabel(from: snapshot), "1.5M / 2.0M")
    }

    func testTokensLabelReturnsUnavailableWhenMissing() {
        let snapshot = makeSnapshot()

        XCTAssertEqual(ContextWindowFormatter.tokensLabel(from: snapshot), "Unavailable")
    }

    func testThresholdLabelReturnsUnavailableWhenMissing() {
        let snapshot = makeSnapshot(used: 1_000, window: 128_000)

        XCTAssertEqual(ContextWindowFormatter.thresholdLabel(from: snapshot), "Unavailable")
    }

    func testThresholdLabelReturnsUnavailableWhenZero() {
        let snapshot = makeSnapshot(used: 1_000, window: 128_000, thresholdTokens: 0)

        XCTAssertEqual(ContextWindowFormatter.thresholdLabel(from: snapshot), "Unavailable")
    }

    func testCostLabelFormatsDollars() {
        let snapshot = makeSnapshot(used: 1_000, window: 128_000, estimatedCost: 0.1234)

        XCTAssertEqual(ContextWindowFormatter.costLabel(from: snapshot), "$0.1234")
    }

    func testCostLabelReturnsUnavailableWhenMissing() {
        let snapshot = makeSnapshot(used: 1_000, window: 128_000)

        XCTAssertEqual(ContextWindowFormatter.costLabel(from: snapshot), "Unavailable")
    }

    func testInputTokensLabelReturnsUnavailableWhenMissing() {
        let snapshot = makeSnapshot(window: 128_000, outputTokens: 500)

        XCTAssertEqual(ContextWindowFormatter.inputTokensLabel(from: snapshot), "Unavailable")
    }

    func testOutputTokensLabelReturnsUnavailableWhenMissing() {
        let snapshot = makeSnapshot(window: 128_000, inputTokens: 500)

        XCTAssertEqual(ContextWindowFormatter.outputTokensLabel(from: snapshot), "Unavailable")
    }

    func testFormatTokensSmallNumber() {
        XCTAssertEqual(ContextWindowFormatter.formatTokens(500), "500")
    }

    func testFormatTokensThousand() {
        XCTAssertEqual(ContextWindowFormatter.formatTokens(1_234), "1.2K")
    }

    func testFormatTokensMillion() {
        XCTAssertEqual(ContextWindowFormatter.formatTokens(1_500_000), "1.5M")
    }
}
