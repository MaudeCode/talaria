import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

extension XCTestCase {
    /// `measure` takes a synchronous body, but the paths worth budgeting here
    /// are main-actor and async. This runs one iteration to completion on the main actor and keeps
    /// the metrics attached to the caller's test case. A body that skips skips
    /// the test once `measure` returns, since `measure`'s block cannot throw.
    @MainActor
    func measureAsync(
        metrics: [any XCTMetric],
        options: XCTMeasureOptions,
        timeout: TimeInterval = 120,
        _ body: @escaping @MainActor (XCTestCase) async throws -> Void
    ) throws {
        var skip: XCTSkip?
        measure(metrics: metrics, options: options) {
            let iteration = expectation(description: "Performance iteration")
            Task { @MainActor in
                defer { iteration.fulfill() }
                do {
                    try await body(self)
                } catch let error as XCTSkip {
                    skip = error
                } catch {
                    XCTFail("Performance iteration failed: \(error)")
                }
            }
            wait(for: [iteration], timeout: timeout)
        }
        if let skip { throw skip }
    }

    /// Three iterations, matching the repo's existing performance budgets:
    /// enough for XCTest to report a spread, cheap enough to leave in CI.
    func performanceOptions(manualWindow: Bool = false, iterations: Int = 3) -> XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        if manualWindow {
            options.invocationOptions = [.manuallyStart, .manuallyStop]
        }
        return options
    }
}

/// Remote media the server could not type, resolved for its transcript row and exported (TAL-866).
///
/// Both paths used to decode the bytes as an image, where ImageIO probes a WAV's RIFF header as WebP, and then build
/// an `AVAudioPlayer`, which starts the audio subsystem. A header check now names the audio first, so a WAV reaches
/// neither probe.
@MainActor
final class UnknownMediaProbePerformanceTests: XCTestCase {
    func testOneSecondWAVResolvesAndExportsWithoutImageOrPlayerProbes() throws {
        let wav = TestAudio.wavData(seconds: 1)
        let reference = TranscriptMediaReference(url: "https://media.example.test/clip", name: "clip", mediaKind: .unsupported)
        var durations: [Duration] = []

        try measureAsync(metrics: [XCTClockMetric()], options: performanceOptions(manualWindow: true)) { test in
            TranscriptProbeRecorder.reset()
            let start = ContinuousClock.now
            test.startMeasuring()
            guard case .audio = await TranscriptMediaResolvedRemoteView.resolve(wav) else {
                return XCTFail("The WAV did not resolve as audio")
            }
            let payload = TranscriptMediaExportSupport.payload(for: reference, data: wav)
            test.stopMeasuring()
            durations.append(ContinuousClock.now - start)
            XCTAssertEqual(payload.filename, "clip.wav")
            XCTAssertEqual(TranscriptProbeRecorder.counts, [:])
        }

        // `measure` discards its first iteration, which pays any probe's one-time setup: an ImageIO codec plugin,
        // the audio subsystem. Run alone, this test makes that call cold.
        let attachment = XCTAttachment(string: "First resolve and export: \(durations.first ?? .zero)")
        attachment.name = "Unknown media first call"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
